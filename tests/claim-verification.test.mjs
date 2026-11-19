// The Intelligence tab's verification words and options (src/lib/claim-registry.ts,
// 20261104200000), held to the migration: every reason registry v2 can emit
// has words, every authoritative method says what evidence it needs, and the
// options offered match what claim_verify accepts. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  METHOD_EVIDENCE,
  REASON_TEXT,
  decisionLine,
  evidenceChoices,
  evidenceLine,
  formatBytes,
  reviewOptions,
  shortHash,
} from "../src/lib/claim-registry.ts";

const SQL = readFileSync("supabase/migrations/20261104200000_claim_verification.sql", "utf8");
const V1 = readFileSync("supabase/migrations/20261103220000_claim_registry.sql", "utf8");
const fn = SQL.slice(SQL.indexOf("create or replace function claim_registry("), SQL.indexOf("revoke all on function claim_registry("));
const SHA = "a".repeat(56) + "0123abcd";

const intervals = [
  { kind: "warranty_guarantee", label: "Warranty or guarantee", review_days: 180, authoritative_methods: ["client_contract", "manufacturer_document"] },
  { kind: "contact_identity", label: "Contact or identity detail", review_days: 90, authoritative_methods: ["structured_record"] },
  { kind: "unclassified", label: "Not yet classified", review_days: 90, authoritative_methods: [] },
];
const registry = {
  intervals,
  evidence: [
    { id: "e1", type: "document", label: "Signed agreement", sha256: SHA, intact: true, captured_on: null },
    { id: "e2", type: "document", label: "Old scan", sha256: SHA, intact: false, captured_on: null },
    { id: "e3", type: "capture", label: "Listing capture", sha256: SHA, intact: true, captured_on: "2026-11-02" },
  ],
  locations: [
    { id: "l1", label: "North office", phone: "555.020.0777", identity_version: 2, workspace_slug: null },
    { id: "l2", label: "Forklift office", phone: "555-020-0002", identity_version: 1, workspace_slug: "forklift" },
  ],
};
function claim(over = {}) {
  return {
    id: "c1", status: "confirmed", kind: "warranty_guarantee", superseded_by: null,
    scope: { programs: [], shared: null, unassigned: null },
    verification: { record: null, last_decision: null },
    ...over,
  };
}

test("every reason registry v2 can emit has words", () => {
  const block = fn.slice(fn.indexOf("array_remove(array["), fn.indexOf("], null) reasons"));
  const reasons = [...block.matchAll(/then '([a-z_]+)' end/g)].map((m) => m[1]);
  for (const r of ["verification_unrecorded", "evidence_file_changed", "evidence_location_changed", "scope_changed_since_verified", "status_changed_since_verified", "evidence_expired"])
    assert.ok(reasons.includes(r), `${r} is emitted`);
  for (const r of reasons) assert.ok(REASON_TEXT[r], `no words for ${r}`);
});

test("every authoritative method in the reviewed intervals says what evidence it needs, as claim_verify enforces", () => {
  const block = V1.slice(V1.indexOf("insert into claim_review_intervals"), V1.indexOf("alter table claim_review_intervals enable"));
  const methods = new Set([...block.matchAll(/'(client_[a-z_]+|manufacturer_document|issuer_record|structured_record|platform_record)'/g)].map((m) => m[1]));
  for (const m of methods) assert.ok(METHOD_EVIDENCE[m], `no evidence rule for ${m}`);
  const verify = SQL.slice(SQL.indexOf("create function claim_verify("), SQL.indexOf("revoke all on function claim_verify("));
  for (const [m, rule] of Object.entries(METHOD_EVIDENCE)) {
    if (rule.needs === "location") assert.match(verify, new RegExp(`p_method = '${m}'`));
    else assert.match(verify, new RegExp(`'${m}'[^)]*\\) and e\\.evidence_type <> '${rule.needs}'|p_method in \\([^)]*'${m}'[^)]*\\)[\\s\\S]{0,80}e\\.evidence_type <> '${rule.needs}'`));
  }
});

test("options: classify first; an unverified claim is never verified here; re-review and revoke only with a verification in force", () => {
  assert.deepEqual(reviewOptions(registry, claim({ kind: null })), {
    canClassify: true, canVerify: false, canReview: false, canRevoke: false,
    verifyBlocked: "Classify it before verifying it.", methods: [],
  });
  const unverified = reviewOptions(registry, claim({ status: "unverified" }));
  assert.equal(unverified.canVerify, false);
  assert.match(unverified.verifyBlocked, /next release/);
  const fresh = reviewOptions(registry, claim());
  assert.deepEqual([fresh.canVerify, fresh.canReview, fresh.canRevoke], [true, false, false]);
  assert.deepEqual(fresh.methods, ["client_contract", "manufacturer_document"]);
  const inForce = reviewOptions(registry, claim({ verification: { record: { review_id: "r1" }, last_decision: null } }));
  assert.deepEqual([inForce.canVerify, inForce.canReview, inForce.canRevoke], [false, true, true]);
  const withdrawn = reviewOptions(registry, claim({ status: "unverified", verification: { record: { review_id: "r1" }, last_decision: null } }));
  assert.deepEqual([withdrawn.canVerify, withdrawn.canReview, withdrawn.canRevoke], [false, false, true]);
  const superseded = reviewOptions(registry, claim({ superseded_by: "c2" }));
  assert.deepEqual([superseded.canClassify, superseded.canVerify, superseded.canReview], [false, false, false]);
});

test("evidence choices: intact files of the method's type; locations client-wide or on the claim's own sites", () => {
  assert.deepEqual(evidenceChoices(registry, claim(), "client_contract").map((c) => c.id), ["e1"]);
  assert.deepEqual(evidenceChoices(registry, claim(), "platform_record").map((c) => c.id), ["e3"]);
  assert.match(evidenceChoices(registry, claim(), "platform_record")[0].label, /captured Nov 2, 2026/);
  assert.deepEqual(evidenceChoices(registry, claim(), "structured_record").map((c) => c.id), ["l1"]);
  assert.deepEqual(evidenceChoices(registry, claim({ scope: { programs: ["forklift"] } }), "structured_record").map((c) => c.id), ["l1", "l2"]);
});

test("lines: the evidence a verification stands on, and the last decision when it is not a verification", () => {
  const file = claim({ verification: { record: { evidence: { label: "Signed agreement", type: "document", sha256: SHA, intact: true }, location: null }, last_decision: null } });
  assert.equal(evidenceLine(file), "Evidence: Signed agreement · document · SHA-256 aaaaaaaa…abcd");
  const changed = claim({ verification: { record: { evidence: { label: "Capture", type: "capture", sha256: SHA, intact: false }, location: null }, last_decision: null } });
  assert.match(evidenceLine(changed), /page capture · SHA-256 .+ · file changed$/);
  const loc = claim({ verification: { record: { evidence: null, location: { label: "North office", identity_version: 2, intact: true } }, last_decision: null } });
  assert.equal(evidenceLine(loc), "Evidence: North office location record, version 2");
  assert.equal(evidenceLine(claim()), null);
  const revoked = claim({ verification: { record: null, last_decision: { action: "revoke", at: "2026-11-04T18:00:00Z", by: "Pat (fictional)", reason: "Licence lapsed" } } });
  assert.equal(decisionLine(revoked), "Verification revoked by Pat (fictional) on Nov 4, 2026: Licence lapsed");
  assert.equal(decisionLine(claim({ verification: { record: {}, last_decision: { action: "verify", at: "2026-11-04T18:00:00Z", by: "Pat" } } })), null);
  assert.equal(shortHash(SHA), "aaaaaaaa…abcd");
  assert.deepEqual([formatBytes(900), formatBytes(2048), formatBytes(3 * 1024 * 1024)], ["900 B", "2 KB", "3.0 MB"]);
});
