import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  groupCoreLinkOptions, coreLinkReason, coreLinkErrorMessage, coreParentLabel,
} from "../src/lib/keyword-core-link.ts";

// 20261120190000: the Keywords tab's core link. The rule lives in SQL
// (keyword_core_parent_link.test.sql runs it); this covers the shaping, the
// reason bounds, the refusal text and that the UI only goes through the RPCs.

const row = (o) => ({ keyword_id: "k1", parent_id: "p1", parent_keyword: "solar installation wichita ks", parent_city: "Wichita",
  list_version: 2, is_current: false, problem: null, ...o });

test("options group per keyword: current link apart, only eligible candidates, no duplicates", () => {
  const m = groupCoreLinkOptions([
    row({}),
    row({ parent_id: "p2", parent_keyword: "solar company", parent_city: null }),
    row({ parent_id: "p2", parent_keyword: "solar company", parent_city: null }),
    row({ parent_id: "p9", problem: "city_mismatch: x" }),
    row({ keyword_id: "k2", parent_id: "p1", is_current: true, problem: "parent_inactive: the core keyword is inactive." }),
  ]);
  assert.deepEqual(m.get("k1").candidates.map((c) => c.id), ["p1", "p2"]);
  assert.equal(m.get("k1").current, null);
  assert.equal(m.get("k2").current.id, "p1");
  assert.match(m.get("k2").current.problem, /^parent_inactive/);
  assert.deepEqual(m.get("k2").candidates, []);
  assert.equal(m.has("k3"), false);
});

test("a reason is 3 to 500 characters after trimming, like the database", () => {
  assert.equal(coreLinkReason(null).ok, false);
  assert.equal(coreLinkReason("  ab  ").ok, false);
  assert.equal(coreLinkReason("x".repeat(501)).ok, false);
  assert.deepEqual(coreLinkReason("  Same service, city and page.  "), { ok: true, reason: "Same service, city and page." });
});

test("refusals read as sentences; known codes get fixed text", () => {
  assert.equal(coreLinkErrorMessage("city_mismatch: the core keyword is for Wichita, the keyword for Topeka."),
    "The core keyword is for Wichita, the keyword for Topeka.");
  assert.equal(coreLinkErrorMessage("not_team: only a signed-in teammate links a keyword to its core keyword"),
    "Only a signed-in teammate can change core links.");
  assert.equal(coreLinkErrorMessage("Something unexpected"), "Something unexpected");
  assert.equal(coreParentLabel({ keyword: "solar installation wichita ks", listVersion: 2 }), "solar installation wichita ks (core v2)");
});

test("the migration keeps the door team-only, audited, and the gate untouched", () => {
  const sql = readFileSync("supabase/migrations/20261120190000_keyword_core_parent_link.sql", "utf8");
  for (const f of ["keyword_link_core_parent(uuid, uuid, text)", "keyword_unlink_core_parent(uuid, text)"]) {
    assert.match(sql, new RegExp(`revoke all on function ${f.replace(/[()]/g, "\\$&")} from public, anon, authenticated, service_role;`));
    assert.match(sql, new RegExp(`grant execute on function ${f.replace(/[()]/g, "\\$&")} to authenticated;`));
  }
  assert.match(sql, /create policy "team keyword core link events" on keyword_core_link_events to authenticated\s+using \(\(select is_team\(\)\)\) with check \(\(select is_team\(\)\)\);/);
  assert.match(sql, /create trigger keywords_core_parent_guard before insert or update of core_parent_keyword_id on keywords/);
  assert.doesNotMatch(sql, /function (core_keyword_grounding|core_keyword_eligibility|core_keyword_draft_gate|core_keyword_social_gate)\b/);
});

test("the Keywords tab changes links only through the RPCs, as the signed-in user", () => {
  const actions = readFileSync("src/app/core-keyword-actions.ts", "utf8");
  assert.match(actions, /db\.rpc\('keyword_link_core_parent'/);
  assert.match(actions, /db\.rpc\('keyword_unlink_core_parent'/);
  assert.doesNotMatch(actions, /core_parent_keyword_id/);
  assert.doesNotMatch(actions, /createAdminClient|service_role|SERVICE_ROLE/);
  const ui = readFileSync("src/components/keyword-core-link.tsx", "utf8");
  assert.match(ui, /name="reason" required/);
  assert.match(ui, /Link to core keyword/);
  const page = readFileSync("src/app/(app)/clients/[clientId]/keywords/page.tsx", "utf8");
  assert.match(page, /rpc\("keyword_core_link_options"/);
});
