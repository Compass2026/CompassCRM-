// The post page's AI Drafter row (src/lib/drafter-run.ts): what it reports
// about a drafted post and what a person changed after the linter passed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { drafterSummary } from "../src/lib/drafter-run.ts";

const run = {
  id: "r", created_at: "2026-09-25T00:00:00Z", runtime: "claude-worker-skill", attempt: 2, status: "submitted",
  requested_via: "worker", brief_version: "drafter-v1", brief_hash: "sha256:" + "ab".repeat(32), copy_hash: "c".repeat(64),
  claim_ids: ["b", "a"],
  lint: { ok: true, problems: [], warnings: [{ code: "length_outside_preferred", message: "Aim for 450–700 characters." }] },
  target: { service: { page_url: "https://x.test/roof" }, cta: { url: "https://x.test/roof" } },
};
const now = { copy: "x", cta_url: "https://x.test/roof", linkedClaimIds: ["a", "b"], copyHash: "c".repeat(64) };

test("an untouched drafted post: lint passed, short hash, target page, nothing edited", () => {
  const s = drafterSummary(run, now);
  assert.equal(s.lintPassed, true);
  assert.equal(s.briefHashShort, "abababababab");
  assert.equal(s.targetPage, "https://x.test/roof");
  assert.equal(s.claimCount, 2);
  assert.equal(s.warnings.length, 1);
  assert.deepEqual(s.editedAfterCheck, []);
});

test("edits after the check are named: copy, claims, button", () => {
  const s = drafterSummary(run, { ...now, copyHash: "d".repeat(64), linkedClaimIds: ["a"], cta_url: "https://x.test/other" });
  assert.deepEqual(s.editedAfterCheck, ["copy", "claims", "button"]);
});

test("a run whose lint did not pass says so", () => {
  assert.equal(drafterSummary({ ...run, lint: { ok: false } }, now).lintPassed, false);
  assert.equal(drafterSummary({ ...run, lint: null }, now).lintPassed, false);
});
