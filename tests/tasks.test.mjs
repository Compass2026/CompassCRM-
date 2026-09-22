// Pure task logic behind the work views and the task forms (0043).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  describeEvent,
  groupByClient,
  isOverdue,
  parseComment,
  parseTaskFields,
  parseTaskView,
  statusPatch,
  todayIn,
  workerLanes,
  WORKER_ACTOR,
} from "../src/lib/tasks.ts";

const form = (o) => (k) => (k in o ? o[k] : null);
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("an unknown or missing view falls back to 'all', so /tasks is unchanged", () => {
  assert.equal(parseTaskView(undefined), "all");
  assert.equal(parseTaskView("everything"), "all");
  for (const v of ["mine", "unassigned", "overdue", "by_client", "all"]) assert.equal(parseTaskView(v), v);
});

test("today is the agency's (Central) day, not UTC's", () => {
  // 03:30 UTC on Sept 23 is still Sept 22 in Chicago.
  assert.equal(todayIn("America/Chicago", new Date("2026-09-23T03:30:00Z")), "2026-09-22");
  assert.equal(todayIn("UTC", new Date("2026-09-23T03:30:00Z")), "2026-09-23");
});

test("overdue means open with a due date before today", () => {
  const today = "2026-09-22";
  assert.equal(isOverdue({ status: "open", due_date: "2026-09-21" }, today), true);
  assert.equal(isOverdue({ status: "blocked", due_date: "2026-09-01" }, today), true);
  assert.equal(isOverdue({ status: "open", due_date: "2026-09-22" }, today), false);
  assert.equal(isOverdue({ status: "done", due_date: "2026-09-01" }, today), false);
  assert.equal(isOverdue({ status: "open", due_date: null }, today), false);
});

test("unassigned leaves out the worker's lanes only", () => {
  assert.deepEqual([...workerLanes].sort(), ["CLAUDE", "CLAUDE_APPROVAL"]);
});

test("task fields: only what the form posts, validated", () => {
  assert.deepEqual(parseTaskFields(form({ assignee_id: A })), { ok: true, value: { assignee_id: A } });
  assert.deepEqual(parseTaskFields(form({ assignee_id: "" })), { ok: true, value: { assignee_id: null } });
  assert.equal(parseTaskFields(form({ assignee_id: "tom" })).ok, false);
  assert.equal(parseTaskFields(form({ assignee_id: "'; drop table tasks; --" })).ok, false);
  assert.equal(parseTaskFields(form({}), { requireTitle: true }).ok, false);
  assert.equal(parseTaskFields(form({ title: "   " })).ok, false);
  assert.equal(parseTaskFields(form({ title: "x".repeat(201) })).ok, false);
  assert.equal(parseTaskFields(form({ status: "archived" })).ok, false);
  assert.equal(parseTaskFields(form({ due_date: "2026-02-30" })).ok, false);
  assert.equal(parseTaskFields(form({ due_date: "next week" })).ok, false);
  assert.deepEqual(parseTaskFields(form({ due_date: "" })), { ok: true, value: { due_date: null } });
  assert.deepEqual(
    parseTaskFields(form({ title: " Call ", status: "in_progress", due_date: "2026-10-01", notes: "" })),
    { ok: true, value: { title: "Call", status: "in_progress", due_date: "2026-10-01", notes: null } }
  );
  // Worker fields are never read from a form.
  const v = parseTaskFields(form({ owner: "CLAUDE", autonomy_level: "hold", client_id: B, title: "t" }));
  assert.deepEqual(v, { ok: true, value: { title: "t" } });
});

test("comments are trimmed and bounded", () => {
  assert.deepEqual(parseComment(form({ body: "  hi  " })), { ok: true, value: "hi" });
  assert.equal(parseComment(form({ body: " " })).ok, false);
  assert.equal(parseComment(form({ body: "x".repeat(4001) })).ok, false);
});

test("completed_at follows status the way toggleTaskAction always has", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  assert.deepEqual(statusPatch("done", "open", now), { status: "done", completed_at: now.toISOString() });
  assert.deepEqual(statusPatch("open", "done", now), { status: "open", completed_at: null });
  assert.deepEqual(statusPatch("blocked", "open", now), { status: "blocked" });
  assert.deepEqual(statusPatch("done", "done", now), { status: "done" });
});

test("history reads as sentences, with the worker named as such", () => {
  const names = new Map([[A, "Tom"], [B, "Jess"]]);
  assert.equal(describeEvent({ kind: "created", actor_id: null, from_value: null, to_value: "x" }, names), `${WORKER_ACTOR} created the task`);
  assert.equal(describeEvent({ kind: "assignee", actor_id: A, from_value: null, to_value: B }, names), "Tom assigned Jess");
  assert.equal(describeEvent({ kind: "assignee", actor_id: B, from_value: A, to_value: null }, names), "Jess unassigned Tom");
  assert.equal(describeEvent({ kind: "assignee", actor_id: A, from_value: B, to_value: A }, names), "Tom took the task");
  assert.equal(describeEvent({ kind: "assignee", actor_id: B, from_value: B, to_value: null }, names), "Jess dropped the task");
  assert.equal(describeEvent({ kind: "assignee", actor_id: null, from_value: A, to_value: B }, names), `${WORKER_ACTOR} reassigned from Tom to Jess`);
  assert.equal(describeEvent({ kind: "status", actor_id: null, from_value: "open", to_value: "done" }, names), `${WORKER_ACTOR} changed status from open to done`);
  assert.equal(describeEvent({ kind: "due_date", actor_id: A, from_value: "2026-09-01", to_value: null }, names), "Tom cleared the due date");
  assert.match(describeEvent({ kind: "assignee", actor_id: "33333333-3333-4333-8333-333333333333", from_value: null, to_value: A }, names), /^A former teammate/);
});

test("by-client groups keep every task and sort by client name", () => {
  const rows = [
    { id: 1, client_id: B, clients: { name: "Zeta" } },
    { id: 2, client_id: A, clients: { name: "Acme" } },
    { id: 3, client_id: B, clients: { name: "Zeta" } },
  ];
  const g = groupByClient(rows);
  assert.deepEqual(g.map((x) => [x.name, x.tasks.map((t) => t.id)]), [["Acme", [2]], ["Zeta", [1, 3]]]);
});

// Static contract: every task-changing server action checks the team first.
test("every task server action requires a team member before writing", () => {
  const actions = readFileSync("src/app/task-actions.ts", "utf8");
  for (const name of ["createTaskAction", "updateTaskAction", "addTaskCommentAction"]) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    const next = body.indexOf("export async function", 10);
    const fn = next > 0 ? body.slice(0, next) : body;
    assert.ok(fn.indexOf("requireTeamMember") > 0, `${name} checks the team`);
    assert.ok(fn.indexOf("requireTeamMember") < fn.indexOf(".from(\"tasks\")") || !fn.includes(".from(\"tasks\")"), `${name} checks before querying`);
  }
  const legacy = readFileSync("src/app/actions.ts", "utf8");
  for (const name of ["addTaskAction", "toggleTaskAction"]) {
    const body = legacy.slice(legacy.indexOf(`export async function ${name}`));
    const fn = body.slice(0, body.indexOf("export async function", 10));
    assert.ok(fn.includes("await requireTeamMember(supabase)"), `${name} checks the team`);
  }
  assert.match(legacy, /\.eq\("id", taskId\)\s*\.eq\("client_id", clientId\)/, "toggle is scoped to the client it names");
});
