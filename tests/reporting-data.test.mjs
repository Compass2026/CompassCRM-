import { test } from "node:test";
import assert from "node:assert/strict";
import { loadReportMeasurements } from "../src/lib/reporting-data.ts";

function fakeClient(fetchPage) {
  const calls = [];
  return { calls, from(table) {
    assert.equal(table, "report_measurements");
    return { select() { return this; }, eq(column, id) { assert.equal(column, "client_id"); assert.equal(id, "fixture-client"); return this; },
      order(column) { assert.equal(column, "sequence"); return this; },
      range(start, end) { calls.push([start, end]); return fetchPage(start, end); } };
  } };
}
test("measurement loader pages past the API cap without losing early baseline history", async () => {
  const rows = Array.from({ length: 1001 }, (_, sequence) => ({ sequence }));
  const client = fakeClient(async (start, end) => ({ data: rows.slice(start, end + 1), error: null }));
  const result = await loadReportMeasurements(client, "fixture-client");
  assert.equal(result.error, null);
  assert.equal(result.rows.length, 1001);
  assert.equal(result.rows[0].sequence, 0);
  assert.deepEqual(client.calls, [[0, 499], [500, 999], [1000, 1499]]);
});
test("a failed later page never produces a partial, misleading scorecard", async () => {
  const client = fakeClient(async (start) => start === 0 ? { data: Array(500).fill({}), error: null } : { data: null, error: { code: "NETWORK" } });
  const result = await loadReportMeasurements(client, "fixture-client");
  assert.deepEqual(result.rows, []);
  assert.ok(result.error);
});
test("a missing migration has an explicit setup state", async () => {
  const result = await loadReportMeasurements(fakeClient(async () => ({ data: null, error: { code: "42P01" } })), "fixture-client");
  assert.match(result.error, /reviewed database migration/);
});
