// The Intelligence tab's words for claim_registry (src/lib/claim-registry.ts),
// held to the migration: every bucket and reason the SQL can emit has a label,
// unknown figures never read as 0, and affected content links into the CRM.
// Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  COUNT_TILES,
  REASON_TEXT,
  SOURCE_CLASS_LABEL,
  affectedLinks,
  eligibilityLabels,
  fig,
  groupByBucket,
  reasonLines,
  reviewLine,
  verificationLine,
} from "../src/lib/claim-registry.ts";

const SQL = readFileSync("supabase/migrations/20261103220000_claim_registry.sql", "utf8");
const fn = SQL.slice(SQL.indexOf("create function claim_registry("), SQL.indexOf("revoke all on function claim_registry("));

function claim(over = {}) {
  return {
    id: "c1",
    claim: "Zqx 3-Year Workmanship Warranty",
    status: "confirmed",
    legacy_usable: true,
    verification_state: "not_independently_verified",
    bucket: "needs_review",
    reasons: ["unclassified", "method_unrecorded"],
    kind: null,
    kind_label: "Not yet classified",
    recorded_at: "2026-09-12T15:00:00Z",
    verification: {
      method: null,
      authoritative: null,
      authoritative_methods: [],
      verified_at: null,
      verified_by: null,
      verified_by_name: null,
      confirmed_by: "owner@example.test",
      confirmed_on: "2026-10-29T17:02:34Z",
      last_verified_at: "2026-10-29T17:02:34Z",
      changed_since_verified: false,
    },
    freshness: { state: "current", interval_days: 90, review_by: null, due_on: "2027-01-27", days_left: 85 },
    source: { text: "Contract excerpt", url: null, host: null, class: "text_note" },
    scope: { programs: [], shared: null, unassigned: null },
    superseded_by: null,
    supersedes: [],
    supersession_mentioned_by: [],
    phone_location: null,
    affected: { posts: [], drafts: [], published: 0, total: 0 },
    ...over,
  };
}

test("every bucket the SQL assigns has a label, in the SQL's order", () => {
  const order = fn.match(/array_position\(array\[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(order, BUCKET_ORDER);
  for (const b of order) assert.ok(BUCKET_LABEL[b], b);
  const assigned = [...fn.matchAll(/then '([a-z_]+)'\s*(?:when|else)/g)].map((m) => m[1]);
  for (const b of assigned.filter((b) => BUCKET_ORDER.includes(b))) assert.ok(BUCKET_LABEL[b], b);
});

test("every reason the SQL can emit has words", () => {
  const block = fn.slice(fn.indexOf("array_remove(array["), fn.indexOf("], null) reasons"));
  const reasons = [...block.matchAll(/then '([a-z_]+)' end/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 20, `${reasons.length} reasons found`);
  for (const r of reasons) assert.ok(REASON_TEXT[r], `no text for ${r}`);
});

test("every source class the SQL can emit has a label", () => {
  const block = fn.slice(fn.indexOf("case when nullif(btrim(coalesce(b.source"), fn.indexOf("end source_class"));
  const classes = [...block.matchAll(/(?:then|else) '([a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(classes.length, 8);
  for (const c of classes) assert.ok(SOURCE_CLASS_LABEL[c], c);
});

test("unknown is '—', never 0; a real zero stays 0", () => {
  assert.equal(fig(null), "—");
  assert.equal(fig(undefined), "—");
  assert.equal(fig(0), "0");
  assert.equal(fig(7), "7");
  for (const t of COUNT_TILES) assert.ok(BUCKET_LABEL[t.key], t.key);
});

test("verification and review lines", () => {
  assert.equal(
    verificationLine(claim()),
    "Confirmed by owner@example.test on Oct 29, 2026 · method not recorded",
  );
  assert.equal(
    verificationLine(claim({ status: "sourced", verification: { ...claim().verification, confirmed_on: null, last_verified_at: null } })),
    "Never verified · recorded Sep 12, 2026",
  );
  assert.equal(
    verificationLine(claim({ verification: { ...claim().verification, method: "client_contract", verified_at: "2026-11-03T20:00:00Z", verified_by_name: "Crt Member" } })),
    "Verified by Crt Member on Nov 3, 2026 · Client contract",
  );
  assert.equal(reviewLine(claim()), "Not yet classified · review every 90 days · due Jan 27, 2027 (in 85 days)");
  assert.equal(
    reviewLine(claim({ freshness: { state: "overdue", interval_days: 90, review_by: null, due_on: "2026-10-01", days_left: -33 } })),
    "Not yet classified · review every 90 days · was due Oct 1, 2026 (33 days ago)",
  );
  assert.equal(
    reviewLine(claim({ freshness: { state: "never_verified", interval_days: 90, review_by: null, due_on: null, days_left: null } })),
    "Not yet classified · review every 90 days · no review date until verified",
  );
});

test("reasons already said by the bucket are not repeated", () => {
  assert.deepEqual(reasonLines(claim({ bucket: "unverified", reasons: ["unverified", "cited_while_unusable"] })), [
    REASON_TEXT.cited_while_unusable,
  ]);
  assert.deepEqual(
    reasonLines(claim({ bucket: "unverified", reasons: ["unverified", "cited_while_unusable", "published_while_unusable"] })),
    [REASON_TEXT.published_while_unusable],
  );
  assert.deepEqual(reasonLines(claim({ bucket: "stale", reasons: ["overdue", "conflict_noted"] })), [REASON_TEXT.conflict_noted]);
  // Said by the verification and review lines already.
  assert.deepEqual(reasonLines(claim({ reasons: ["never_verified", "unclassified", "method_unrecorded", "summary_source"] })), [
    REASON_TEXT.summary_source,
  ]);
});

test("affected content: published first, CRM links, live link kept", () => {
  const links = affectedLinks("client-1", {
    affected: {
      posts: [
        { id: "p2", platform: "google_business", review_status: "rejected", publish_status: "not_scheduled", published_at: null, published_url: null },
        { id: "p1", platform: "google_business", review_status: "approved", publish_status: "published", published_at: "2026-10-15T16:19:59Z", published_url: "https://local.example.test/p1" },
      ],
      drafts: [{ id: "d1", deliverable: "blog", status: "in_review", title: "Zqx roofing question", published_url: null, published_at: null }],
      published: 1,
      total: 3,
    },
  });
  assert.deepEqual(
    links.map((l) => [l.label, l.state, l.href, l.external]),
    [
      ["Business Profile post", "published Oct 15, 2026", "/clients/client-1/social/p1", "https://local.example.test/p1"],
      ["Business Profile post", "rejected", "/clients/client-1/social/p2", null],
      ["Blog draft: Zqx roofing question", "in review", "/clients/client-1/drafts/d1", null],
    ],
  );
});

test("citable under current rules and independent verification are two separate answers", () => {
  assert.deepEqual(eligibilityLabels(claim()), { citable: "citable under current rules", verified: "not independently verified" });
  assert.deepEqual(eligibilityLabels(claim({ legacy_usable: false })), {
    citable: "not citable under current rules",
    verified: "not independently verified",
  });
  assert.deepEqual(eligibilityLabels(claim({ verification_state: "independently_verified" })).verified, "independently verified");
});

test("supersession notes are tentative; location phones are not client-wide conflicts", () => {
  assert.match(REASON_TEXT.supersession_mentioned, /Tentative; not a recorded replacement/);
  assert.match(REASON_TEXT.phone_potential_mismatch, /^Potential mismatch: .*not evaluated yet/);
  assert.equal(REASON_TEXT.named_as_superseded, undefined);
  assert.equal(REASON_TEXT.phone_differs_from_structured, undefined);
  assert.deepEqual(reasonLines(claim({ reasons: ["matches_location_phone"], phone_location: "North office" })), [
    "Matches the approved phone of the North office location; that location's record governs.",
  ]);
});

test("groups follow the bucket order and skip empty buckets", () => {
  const g = groupByBucket([claim({ id: "a", bucket: "verified" }), claim({ id: "b", bucket: "unverified" }), claim({ id: "c", bucket: "verified" })]);
  assert.deepEqual(g.map((x) => [x.bucket, x.claims.map((c) => c.id)]), [["unverified", ["b"]], ["verified", ["a", "c"]]]);
});
