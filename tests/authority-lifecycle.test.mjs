// The Authority lifecycle rules (src/lib/authority-lifecycle.ts): chips, the
// menu each state offers, 30 / 60 / 90-day end dates on the agency's
// calendar, the server action's validation and history lines. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  statusChip, lifecycleMenu, dismissUntil, agencyToday, planDecision, sameSnapshot, decideErrorText, doneText, historyLine,
  CHANGED_SINCE_LOADED, DISMISS_DAYS,
} from "../src/lib/authority-lifecycle.ts";

const wf = (over = {}) => ({ opportunityId: "o1", status: "open", suppressed: false, dismissed_until: null, effective: "open", reason: null, decidedBy: null, decidedAt: null, ...over });
const ids = (w) => lifecycleMenu(w).map((i) => `${i.id}${i.enabled ? "" : "(off)"}`);

test("menu: open offers Accept, the three dismissals and never recommend", () => {
  assert.deepEqual(ids(wf()), ["accept", "dismiss-30", "dismiss-60", "dismiss-90", "suppress"]);
  assert.ok(lifecycleMenu(wf()).filter((i) => i.dialog).every((i) => i.verb === "dismiss" || i.verb === "suppress"), "dismissals and suppression ask first");
});

test("menu: accepted offers Release and the dismissals; in progress refuses dismissal with the reason", () => {
  assert.deepEqual(ids(wf({ status: "accepted", effective: "accepted" })), ["release", "dismiss-30", "dismiss-60", "dismiss-90", "suppress"]);
  const busy = lifecycleMenu(wf({ status: "accepted", effective: "in_progress" }));
  assert.deepEqual(busy.map((i) => i.id), ["dismiss-30", "dismiss-60", "dismiss-90", "suppress"]);
  assert.ok(busy.every((i) => !i.enabled && /Work is linked and still open/.test(i.reason)));
});

test("menu: dismissed and never-recommend offer only Reopen; an ended dismissal offers Reopen and dismiss again", () => {
  assert.deepEqual(ids(wf({ status: "dismissed", effective: "dismissed", dismissed_until: "2026-12-01", reason: "x" })), ["reopen"]);
  assert.deepEqual(ids(wf({ status: "dismissed", effective: "dismissed", suppressed: true, reason: "x" })), ["reopen"]);
  assert.deepEqual(ids(wf({ status: "dismissed", effective: "open", dismissed_until: "2026-09-01" })), ["reopen", "dismiss-30", "dismiss-60", "dismiss-90", "suppress"]);
  assert.deepEqual(ids(wf({ status: "accepted", effective: "completed" })), []);
  assert.deepEqual(lifecycleMenu(null), []);
});

test("chips", () => {
  assert.equal(statusChip(wf()), null, "open needs no chip");
  assert.equal(statusChip(wf({ status: "accepted", effective: "accepted" })).label, "Accepted");
  assert.equal(statusChip(wf({ status: "accepted", effective: "in_progress" })).label, "In progress");
  assert.equal(statusChip(wf({ status: "accepted", effective: "completed" })).label, "Completed");
  assert.deepEqual(statusChip(wf({ status: "dismissed", effective: "dismissed", dismissed_until: "2026-10-26", reason: "Waiting on photos" })),
    { label: "Dismissed until Oct 26, 2026", tone: "amber", title: "Waiting on photos" });
  assert.equal(statusChip(wf({ status: "dismissed", effective: "dismissed", suppressed: true, reason: "No" })).label, "Never recommend");
  assert.equal(statusChip(wf({ status: "dismissed", effective: "open", dismissed_until: "2026-09-01" })).label, "Dismissal ended Sep 1, 2026");
});

test("30 / 60 / 90 days count from today on the agency's calendar (America/Chicago)", () => {
  const noon = new Date("2026-09-26T17:00:00Z");
  assert.deepEqual(DISMISS_DAYS.map((d) => dismissUntil(d, noon)), ["2026-10-26", "2026-11-25", "2026-12-25"]);
  // 10 PM in Chicago on Sep 26 is already Sep 27 in UTC: still Sep 26 here.
  const late = new Date("2026-09-27T03:00:00Z");
  assert.equal(agencyToday(late), "2026-09-26");
  assert.equal(dismissUntil(30, late), "2026-10-26");
  // Across the November clock change and a year end.
  assert.equal(dismissUntil(30, new Date("2026-10-20T15:00:00Z")), "2026-11-19");
  assert.equal(dismissUntil(90, new Date("2026-11-15T15:00:00Z")), "2027-02-13");
  assert.equal(dismissUntil(60, new Date("2028-01-15T15:00:00Z")), "2028-03-15", "leap year");
});

test("server validation: reason required for dismissal and suppression, days only 30 / 60 / 90, the date computed here", () => {
  const exp = { status: "open", suppressed: false, dismissed_until: null };
  const now = new Date("2026-09-26T17:00:00Z");
  assert.deepEqual(planDecision({ verb: "accept", expected: exp }, now), { verb: "accept", payload: {} });
  assert.deepEqual(planDecision({ verb: "dismiss", days: 60, reason: "  Waiting on photos ", expected: exp }, now),
    { verb: "dismiss", payload: { reason: "Waiting on photos", until: "2026-11-25" } });
  assert.deepEqual(planDecision({ verb: "dismiss", days: 60, reason: "   ", expected: exp }, now), { error: "A reason is required." });
  assert.deepEqual(planDecision({ verb: "dismiss", days: 45, reason: "x", expected: exp }, now), { error: "Choose 30, 60 or 90 days." });
  assert.deepEqual(planDecision({ verb: "suppress", reason: "", expected: exp }, now), { error: "A reason is required." });
  assert.deepEqual(planDecision({ verb: "suppress", reason: "Not a service", expected: exp }, now), { verb: "suppress", payload: { reason: "Not a service" } });
  assert.match(planDecision({ verb: "suppress", reason: "x".repeat(501), expected: exp }, now).error, /under 500/);
  assert.deepEqual(planDecision({ verb: "link", expected: exp }, now), { error: "Unknown action." }, "link is not a lifecycle action here");
  assert.deepEqual(planDecision({ verb: "decision", expected: exp }, now), { error: "Unknown action." });
});

test("the page's snapshot must match the stored workflow (duplicates and a second tab)", () => {
  const a = { status: "open", suppressed: false, dismissed_until: null };
  assert.ok(sameSnapshot(a, { ...a }));
  assert.ok(!sameSnapshot(a, { ...a, status: "accepted" }));
  assert.ok(!sameSnapshot({ status: "dismissed", suppressed: false, dismissed_until: "2026-10-26" }, { status: "dismissed", suppressed: false, dismissed_until: "2026-11-25" }));
  assert.ok(!sameSnapshot({ status: "dismissed", suppressed: true, dismissed_until: null }, { status: "dismissed", suppressed: false, dismissed_until: null }));
  assert.match(CHANGED_SINCE_LOADED, /changed since the page loaded/);
});

test("authority_decide's refusals as a person reads them", () => {
  assert.match(decideErrorText({ code: "42501", message: "x" }), /Only a signed-in Compass teammate/);
  assert.equal(decideErrorText({ code: "22023", message: "Work is linked to this opportunity and still open; finish or close it first" }),
    "Work is linked to this opportunity and still open; finish or close it first.");
  assert.equal(decideErrorText({ code: "P0002" }), "This opportunity no longer exists.");
  assert.match(decideErrorText({ code: "XX000", message: "boom" }), /no clear answer/);
  assert.equal(doneText("dismiss", { until: "2026-12-25" }), "Dismissed until Dec 25, 2026.");
  assert.match(doneText("suppress", {}), /Reopen it from the Dismissed group/);
});

test("history lines name the teammate, the reason and the end date", () => {
  const members = [{ id: "m1", name: "Sam Team", email: "sam@example.test" }];
  const e = (kind, detail = {}, actor_kind = "team", actor_id = "m1") => historyLine({ opportunity_id: "o", run_id: null, created_at: "2026-09-26T17:00:00Z", kind, actor_kind, actor_id, detail }, members);
  assert.deepEqual(e("dismissed", { reason: "Waiting on photos", until: "2026-10-26" }), { at: "2026-09-26T17:00:00Z", kind: "dismissed", text: "Dismissed until Oct 26, 2026 — “Waiting on photos”", actor: "Sam Team" });
  assert.equal(e("suppressed", { reason: "Not offered", until: null }).text, "Never recommend again — “Not offered”");
  assert.equal(e("reopened", { reason: "dismissal expired" }, "engine", null).text, "Reopened — “dismissal expired”");
  assert.equal(e("reopened", { reason: "dismissal expired" }, "engine", null).actor, "engine");
  assert.equal(e("section_changed", { from: { section: "fix_now" }, to: { section: "needs_decision" } }, "engine", null).text, "Moved section fix now → needs decision");
  assert.equal(e("linked", { kind: "social_post" }).text, "Work linked (social post)");
  assert.equal(e("accepted", {}, "team", "gone").actor, "teammate");
});
