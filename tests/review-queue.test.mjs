// The review queue's pure rules (src/lib/review-queue.ts, 20261116150000):
// stage grouping, which decisions a stage allows (Approve & schedule never
// offered when the publisher would not send the post; nothing offered outside
// final review), and the proposed publish times (planned slot if still ahead,
// otherwise the next weekday; one per destination per day; never a day that
// destination already has scheduled; 10:00 Central across DST). The
// migration's file is read to hold the SQL stages to the same names.
// Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REVIEW_STAGES,
  centralDay,
  centralInstant,
  centralLocalInput,
  centralToIso,
  decisionsFor,
  groupByStage,
  pendingChangeLine,
  proposeTimes,
  stageLabels,
} from "../src/lib/review-queue.ts";

// The latest definition of review_queue (20261117010000 redefines it with pending changes).
const SQL = readFileSync("supabase/migrations/20261117010000_review_pending_changes.sql", "utf8");

function item(over = {}) {
  return {
    id: "p1", client_id: "c1", client_name: "Harbor Lane Plumbing (fictional)", client_status: "active", platform: "facebook",
    copy: "Slow drain?", cta_type: null, cta_url: null, service_name: "Drains", keyword: "drain cleaning",
    review_status: "in_review", publish_status: "not_scheduled", submitted_at: "2026-11-10T15:00:00Z", reviewed_at: null,
    review_note: null, rejection_category: null, scheduled_at: null, approved_publish_at: null, published_at: null,
    published_url: null, external_post_id: null, error: null, publish_attempts: 0, no_image_reason: null,
    social_account_id: "a1", destination_name: "Harbor Lane Page", destination_key: "facebook:111", approved_destination: null,
    planned_date: null, media: [], grounding_problems: [], publish_problems: [], client_hold: null, stage: "ready",
    last_feedback: null, rejections: 0, ...over,
  };
}

test("every stage the SQL can emit has a label, and the labels cover only those stages", () => {
  const fn = SQL.slice(SQL.indexOf("create or replace function review_queue("), SQL.indexOf("revoke all on function review_queue("));
  assert.ok(fn.includes("content_edit_holds h where h.post_id = p.id and h.closed_at is null) then 'ready'"),
    "Ready requires no open pending change");
  const emitted = new Set([...fn.matchAll(/then '([a-z_]+)'\n/g)].map((m) => m[1]));
  for (const s of emitted) if (s !== "draft") assert.ok(stageLabels[s], `no label for ${s}`);
  for (const s of REVIEW_STAGES) assert.ok(emitted.has(s), `${s} is never emitted`);
});

test("decisions: only a ready post is decided; a channel the publisher won't send is approve-only", () => {
  assert.deepEqual(decisionsFor(item()), { approveAndSchedule: true, approveOnly: true, reject: true, why: null });
  const off = decisionsFor(item({ publish_problems: ["Publishing is not enabled for this account."] }));
  assert.equal(off.approveAndSchedule, false);
  assert.equal(off.approveOnly, true);
  assert.match(off.why, /Approve only: .*not enabled/);
  for (const stage of ["needs_preparation", "blocked"]) {
    const d = decisionsFor(item({ stage }));
    assert.deepEqual([d.approveAndSchedule, d.approveOnly, d.reject], [false, false, true], stage);
  }
  for (const stage of ["revising", "approved", "scheduled", "publishing", "published", "failed"]) {
    const d = decisionsFor(item({ stage, review_status: stage === "revising" ? "rejected" : "approved" }));
    assert.deepEqual([d.approveAndSchedule, d.approveOnly, d.reject], [false, false, false], stage);
  }
});

test("grouping keeps every item and files unknown stages under needs preparation", () => {
  const g = groupByStage([item({ id: "a" }), item({ id: "b", stage: "scheduled" }), item({ id: "c", stage: "mystery" })]);
  assert.deepEqual(g.get("ready").map((i) => i.id), ["a"]);
  assert.deepEqual(g.get("scheduled").map((i) => i.id), ["b"]);
  assert.deepEqual(g.get("needs_preparation").map((i) => i.id), ["c"]);
});

test("proposed times: a future slot date is kept; an expired one moves to the next weekday", () => {
  const today = "2026-11-16"; // a Monday
  const p = proposeTimes([
    item({ id: "future", planned_date: "2026-11-18", destination_key: "facebook:1" }),
    item({ id: "expired", planned_date: "2026-11-09", destination_key: "facebook:2" }),
  ], today);
  assert.equal(centralDay(p.get("future")), "2026-11-18");
  assert.equal(centralDay(p.get("expired")), "2026-11-17");
});

test("proposed times: one per destination per day, skipping weekends and days already scheduled", () => {
  const today = "2026-11-19"; // Thursday
  const items = [
    item({ id: "sched", stage: "scheduled", scheduled_at: "2026-11-20T16:00:00Z", destination_key: "gbp:loc1" }),
    item({ id: "x1", destination_key: "gbp:loc1", submitted_at: "2026-11-10T01:00:00Z" }),
    item({ id: "x2", destination_key: "gbp:loc1", submitted_at: "2026-11-10T02:00:00Z" }),
    item({ id: "y1", destination_key: "gbp:loc2" }),
  ];
  const p = proposeTimes(items, today);
  assert.equal(p.has("sched"), false, "a scheduled post keeps its own time");
  assert.equal(centralDay(p.get("x1")), "2026-11-23", "Fri 20 is taken, 21-22 is a weekend");
  assert.equal(centralDay(p.get("x2")), "2026-11-24");
  assert.equal(centralDay(p.get("y1")), "2026-11-20", "another location's day is free");
});

test("Central time: 10:00 on both sides of the DST change, and datetime-local round trips", () => {
  assert.equal(centralInstant("2026-10-30"), "2026-10-30T15:00:00.000Z"); // CDT, UTC-5
  assert.equal(centralInstant("2026-11-16"), "2026-11-16T16:00:00.000Z"); // CST, UTC-6
  assert.equal(centralLocalInput("2026-11-16T16:00:00.000Z"), "2026-11-16T10:00");
  assert.equal(centralToIso("2026-11-16T10:00"), "2026-11-16T16:00:00.000Z");
  assert.equal(centralToIso("2026-07-01T10:30"), "2026-07-01T15:30:00.000Z");
  assert.equal(centralToIso("tomorrow"), null);
});

test("a pending change is named for the reviewer, and a stale one says it will be refiled or withdrawn", () => {
  const c = { ref: "0e1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", kind: "replace_copy", summary: "Revise one Facebook post", requested_by: "Claude via Executive OS",
    opened_at: "2026-11-17T10:00:00Z", stale: false };
  assert.equal(pendingChangeLine(c), "A copy change requested by Claude via Executive OS is waiting for approval in Executive OS.");
  assert.match(pendingChangeLine({ ...c, kind: "replace_media", stale: true }), /^A new image .* \(the post changed since it was requested; it will be refiled or withdrawn\)\.$/);
  // A needs-preparation item with a pending change offers only Reject.
  const d = decisionsFor(item({ stage: "needs_preparation", pending_changes: [c] }));
  assert.deepEqual([d.approveAndSchedule, d.approveOnly, d.reject], [false, false, true]);
});
