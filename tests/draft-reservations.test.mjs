// Reserve for on Generate draft and Regenerate, and the hold shown on the
// Planner / draft page (src/lib/draft-reservations.ts). The database enforces
// the same rules (supabase/tests/sandbox/reserve_draft_requests.test.sql,
// reserve_draft_regenerate.test.sql).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLAIM_MS, LABEL, RESERVE_OPTIONS, liveHold, parseReserveFor, reserveError, reservedText } from "../src/lib/draft-reservations.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

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

test("a reserved answer reads as who holds it; an unreserved one is the Routine's", () => {
  const fmt = (iso) => `<${iso}>`;
  assert.equal(reservedText({ draft_id: "d", task_id: "t", reserved_for: "claude-operator", expires_at: "2026-10-18T23:00:00Z" }, fmt),
    "Reserved for claude-operator until <2026-10-18T23:00:00Z>. The worker Routine was not started.");
  assert.equal(reservedText({ reserved_for: "claude-operator" }, fmt), "Reserved for claude-operator. The worker Routine was not started.");
  assert.equal(reservedText({ draft_id: "d", task_id: "t" }, fmt), null, "0067's answer: sent to the Routine");
  assert.equal(reservedText(null, fmt), null);
  assert.equal(reservedText({ reserved_for: "" }, fmt), null);
});

test("Generate and Regenerate share one label rule with the database, and Regenerate offers the same choices", () => {
  const rule = "'^[a-z0-9][a-z0-9-]{1,39}$'";
  assert.equal(`'${LABEL.source}'`, rule);
  for (const m of ["supabase/migrations/20261018220000_reserve_draft_requests.sql", "supabase/migrations/20261018230000_reserve_draft_regenerate.sql"]) {
    const sql = read(m);
    assert.ok(sql.includes(`v_who !~ ${rule}`), `${m} checks the same label`);
    assert.ok(sql.includes("v_who = 'worker-routine'"), `${m} refuses the Routine's own label`);
    assert.ok(sql.includes("claimed_by_other: % holds this request until %"), `${m} raises the CD409 reserveError reads`);
  }
  const regen = read("supabase/migrations/20261018230000_reserve_draft_regenerate.sql");
  assert.ok(regen.includes("drop function content_draft_regenerate(uuid, text);"), "the two-argument function is dropped");
  assert.match(regen, /if v_who is null then\s+perform fire_foundation_worker\(d\.client_id, 'Content draft request ' \|\| d\.id\);\s+return jsonb_build_object\('draft_id', d\.id, 'task_id', v_task\);/,
    "unset fires and answers exactly as 0067 did");
  const form = read("src/components/drafts/draft-forms.tsx");
  const regenForm = form.slice(form.indexOf("export function RegenerateForm"));
  assert.ok(regenForm.includes('name="reserve_for"') && regenForm.includes("RESERVE_OPTIONS.map"), "Regenerate has the Reserve for select");
  const actions = read("src/app/draft-actions.ts");
  const regenAction = actions.slice(actions.indexOf("export async function regenerateDraftAction"));
  assert.ok(regenAction.includes('parseReserveFor(form.get("reserve_for"))') && regenAction.includes("p_reserve_for: reserve.value"),
    "the action passes Reserve for to content_draft_regenerate");
});
