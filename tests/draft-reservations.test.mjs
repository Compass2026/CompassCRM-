// Reserve for on Generate draft and the hold shown on the Planner / draft page
// (src/lib/draft-reservations.ts). The database enforces the same rules
// (supabase/tests/sandbox/reserve_draft_requests.test.sql).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAIM_MS, RESERVE_OPTIONS, liveHold, parseReserveFor, reserveError } from "../src/lib/draft-reservations.ts";

test("Reserve for: empty is the Routine, a short label reserves, anything else is refused", () => {
  assert.equal(RESERVE_OPTIONS[0].value, "", "the default is the Routine");
  assert.ok(RESERVE_OPTIONS.some((o) => o.value === "claude-operator"));
  for (const o of RESERVE_OPTIONS) assert.equal(parseReserveFor(o.value).error, undefined, `${o.value} is a valid choice`);
  assert.deepEqual(parseReserveFor(""), {});
  assert.deepEqual(parseReserveFor(null), {});
  assert.deepEqual(parseReserveFor("   "), {});
  assert.deepEqual(parseReserveFor("worker-routine"), {}, "the Routine's own label is the default, not a reservation");
  assert.deepEqual(parseReserveFor(" claude-operator "), { value: "claude-operator" });
  assert.deepEqual(parseReserveFor("operator-td"), { value: "operator-td" });
  for (const bad of ["Claude Operator", "x", "-lead", "op;drop", "a".repeat(41), "claude_operator"]) {
    assert.ok(parseReserveFor(bad).error, `${bad} is refused`);
  }
});

test("a hold is live for the claim's hour, then gone", () => {
  const now = Date.parse("2026-10-18T22:00:00Z");
  const at = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
  assert.equal(CLAIM_MS, 3_600_000);
  assert.deepEqual(liveHold({ claimed_by: "claude-operator", claimed_at: at(10) }, now),
    { by: "claude-operator", until: "2026-10-18T22:50:00.000Z" });
  assert.equal(liveHold({ claimed_by: "claude-operator", claimed_at: at(60) }, now), null, "exactly an hour: expired");
  assert.equal(liveHold({ claimed_by: "claude-operator", claimed_at: at(61) }, now), null);
  assert.equal(liveHold({ claimed_by: null, claimed_at: null }, now), null);
  assert.equal(liveHold({ claimed_by: "claude-operator", claimed_at: null }, now), null);
  assert.equal(liveHold({ claimed_by: "claude-operator", claimed_at: "not a time" }, now), null);
  assert.equal(liveHold(null, now), null);
});

test("the database's CD409 reads as who holds the request and until when", () => {
  const fmt = (iso) => `<${iso}>`;
  assert.equal(
    reserveError("claimed_by_other: claude-operator holds this request until 2026-10-18 22:51:24.123456+00", fmt),
    "claude-operator already holds this request until <2026-10-18T22:51:24.123Z>. Wait for it, or leave Reserve for on the Routine.");
  assert.equal(reserveError("Choose the page type", fmt), "Choose the page type", "other refusals pass through");
});
